// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { KeepAlive, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalView from "../TerminalView.vue";

const markTaskSwitchMountedMock = vi.fn();
const markTaskSwitchReadyMock = vi.fn();
const setWebviewFocusMock = vi.fn(async () => {});
const emptyBuffer = () => ({
  type: "normal" as const,
  length: 0,
  getLine: () => undefined,
});
const useTerminalMock = vi.fn(() => ({
  terminal: ref({
    focus: focusMock,
    buffer: {
      active: emptyBuffer(),
      normal: emptyBuffer(),
      onBufferChange: () => ({ dispose: () => {} }),
    },
  }),
  init: initMock,
  startListening: startListeningMock,
  fit: fitMock,
  fitDeferred: fitDeferredMock,
  redraw: redrawMock,
  ensureConnected: ensureConnectedMock,
  pause: pauseMock,
  dispose: disposeMock,
}));

const focusMock = vi.fn();
const initMock = vi.fn();
const startListeningMock = vi.fn(async () => {});
const fitMock = vi.fn();
const fitDeferredMock = vi.fn();
const redrawMock = vi.fn();
const ensureConnectedMock = vi.fn(async () => {});
const pauseMock = vi.fn();
const disposeMock = vi.fn();
const originalResizeObserver = globalThis.ResizeObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

async function flushLifecycle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

vi.mock("../../composables/useTerminal", () => ({
  useTerminal: (...args: unknown[]) => useTerminalMock(...args),
}));

vi.mock("../../tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setFocus: setWebviewFocusMock,
  }),
}));

vi.mock("../../composables/terminalSessionRecovery", () => ({
  shouldDelayConnectUntilAfterInitialLayout: () => false,
}));

vi.mock("../../perf/taskSwitchPerf", () => ({
  markTaskSwitchMounted: (...args: unknown[]) => markTaskSwitchMountedMock(...args),
  markTaskSwitchReady: (...args: unknown[]) => markTaskSwitchReadyMock(...args),
}));

describe("TerminalView", () => {
  beforeEach(() => {
    useTerminalMock.mockClear();
    focusMock.mockReset();
    initMock.mockReset();
    startListeningMock.mockReset();
    fitMock.mockReset();
    fitDeferredMock.mockReset();
    redrawMock.mockReset();
    ensureConnectedMock.mockReset();
    pauseMock.mockReset();
    disposeMock.mockReset();
    markTaskSwitchMountedMock.mockReset();
    markTaskSwitchReadyMock.mockReset();
    setWebviewFocusMock.mockClear();

    globalThis.ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    } as typeof ResizeObserver;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("focuses the active terminal on first mount", async () => {
    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: true,
        agentTerminal: true,
      },
    });

    await flushLifecycle();

    expect(useTerminalMock).toHaveBeenCalledWith(
      "session-1",
      undefined,
      expect.objectContaining({ agentTerminal: true }),
    );
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(startListeningMock).toHaveBeenCalledTimes(1);
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(markTaskSwitchMountedMock).toHaveBeenCalledWith("session-1");
    expect(markTaskSwitchReadyMock).toHaveBeenCalledWith("session-1", "cold");

    wrapper.unmount();
  });

  it("does not steal focus while a modal is open", async () => {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    document.body.appendChild(modal);

    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: true,
      },
    });

    await flushLifecycle();

    expect(focusMock).not.toHaveBeenCalled();

    wrapper.unmount();
    modal.remove();
  });

  it("records warm task switch readiness when an existing terminal becomes active", async () => {
    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: false,
        agentTerminal: true,
      },
    });
    await flushLifecycle();

    markTaskSwitchMountedMock.mockReset();
    markTaskSwitchReadyMock.mockReset();

    await wrapper.setProps({ active: true });
    await flushLifecycle();

    expect(markTaskSwitchMountedMock).toHaveBeenCalledWith("session-1");
    expect(markTaskSwitchReadyMock).toHaveBeenCalledWith("session-1", "warm");

    wrapper.unmount();
  });

  it("records warm task switch readiness even if native focus restore is slow", async () => {
    setWebviewFocusMock.mockImplementationOnce(() => new Promise(() => {}));

    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: false,
        agentTerminal: true,
      },
    });
    await flushLifecycle();

    markTaskSwitchMountedMock.mockReset();
    markTaskSwitchReadyMock.mockReset();

    await wrapper.setProps({ active: true });
    await Promise.resolve();
    await nextTick();

    expect(markTaskSwitchMountedMock).toHaveBeenCalledWith("session-1");
    expect(markTaskSwitchReadyMock).toHaveBeenCalledWith("session-1", "warm");

    wrapper.unmount();
  });

  it("records warm task switch readiness even if stream attach is slow", async () => {
    startListeningMock.mockImplementationOnce(() => new Promise(() => {}));

    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: false,
        agentTerminal: true,
      },
    });
    await flushLifecycle();

    markTaskSwitchMountedMock.mockReset();
    markTaskSwitchReadyMock.mockReset();

    await wrapper.setProps({ active: true });
    await Promise.resolve();
    await nextTick();

    expect(markTaskSwitchMountedMock).toHaveBeenCalledWith("session-1");
    expect(markTaskSwitchReadyMock).toHaveBeenCalledWith("session-1", "warm");

    wrapper.unmount();
  });

  it("pauses the daemon stream while kept-alive terminals are deactivated", async () => {
    const Harness = defineComponent({
      props: {
        visible: {
          type: Boolean,
          required: true,
        },
      },
      setup(props) {
        return () =>
          h(KeepAlive, null, () =>
            props.visible
              ? h(TerminalView, {
                  sessionId: "session-1",
                  active: true,
                  agentTerminal: true,
                })
              : null,
          );
      },
    });

    const wrapper = mount(Harness, {
      attachTo: document.body,
      props: {
        visible: true,
      },
    });
    await flushLifecycle();

    expect(startListeningMock).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ visible: false });
    await flushLifecycle();

    expect(pauseMock).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ visible: true });
    await flushLifecycle();

    expect(startListeningMock).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it("does not pause the active terminal when the app window loses focus", async () => {
    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: true,
        agentTerminal: true,
      },
    });
    await flushLifecycle();

    expect(startListeningMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("blur"));
    await flushLifecycle();
    window.dispatchEvent(new Event("focus"));
    await flushLifecycle();

    expect(pauseMock).not.toHaveBeenCalled();
    expect(startListeningMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it("restores native webview focus before focusing the terminal on mount", async () => {
    const wrapper = mount(TerminalView, {
      attachTo: document.body,
      props: {
        sessionId: "session-1",
        active: true,
        agentTerminal: true,
      },
    });
    await flushLifecycle();

    expect(setWebviewFocusMock).toHaveBeenCalledTimes(1);
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(setWebviewFocusMock.mock.invocationCallOrder[0]).toBeLessThan(
      focusMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    wrapper.unmount();
  });
});
