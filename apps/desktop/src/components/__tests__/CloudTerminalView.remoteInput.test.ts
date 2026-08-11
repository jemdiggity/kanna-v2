// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clientFactory: vi.fn(),
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  selection: "",
  sendInput: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    getSelection() {
      return harness.selection;
    }
    onData() { return { dispose() {} }; }
    attachCustomKeyEventHandler(listener: (event: KeyboardEvent) => boolean) {
      harness.keyHandler = listener;
    }
    onData() { return { dispose() {} }; }
    loadAddon() {}
    open() {}
    reset() {}
    write() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("../../services/desktopRelayTerminal", () => ({
  createConfiguredDesktopRelayTerminalClient: harness.clientFactory,
}));

vi.mock("../../services/desktopLanTerminal", () => ({
  createConfiguredDesktopLanTerminalClient: vi.fn(),
}));

vi.mock("../../theme/runtime", () => ({
  useThemeRuntime: () => ({ effectiveCodeTheme: { __v_isRef: true, value: "dark" } }),
}));

vi.mock("../../theme/theme", () => ({
  getTerminalTheme: () => ({}),
}));

vi.mock("../../e2eTerminalBuffers", () => ({
  registerE2ETerminalBuffer: () => () => {},
}));

function terminalClient() {
  return {
    close: vi.fn(),
    observeTerminal: vi.fn((options: {
      taskId: string;
      listener: (event: { type: "ready"; taskId: string }) => void;
    }) => {
      queueMicrotask(() => options.listener({ type: "ready", taskId: options.taskId }));
      return { close: vi.fn() };
    }),
    sendInput: harness.sendInput,
    resize: vi.fn(async () => {}),
  };
}

describe("CloudTerminalView remote input", () => {
  beforeEach(() => {
    harness.clientFactory.mockReset();
    harness.keyHandler = null;
    harness.selection = "";
    harness.sendInput.mockReset();
    harness.sendInput.mockResolvedValue(undefined);
    harness.clientFactory.mockResolvedValue(terminalClient());
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  });

  it("sends Shift+Enter as kitty CSI-u modified Enter", async () => {
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: {
        ownerDesktopId: "desktop-1",
        ownerTaskId: "task-1",
        transport: "cloud",
      },
    });
    await flushPromises();
    const event = {
      type: "keydown",
      key: "Enter",
      shiftKey: true,
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(harness.keyHandler?.(event)).toBe(false);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.sendInput).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1",
      data: "\x1b[13;2u",
    });
    wrapper.unmount();
  });

  it("copies selected text with Command+C", async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    harness.selection = "selected remote output";
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: { ownerDesktopId: "desktop-1", ownerTaskId: "task-1" },
    });
    await flushPromises();
    const event = {
      type: "keydown",
      key: "c",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(harness.keyHandler?.(event)).toBe(false);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected remote output");
    expect(harness.sendInput).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("leaves Command+C to xterm when there is no selection", async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const { default: CloudTerminalView } = await import("../CloudTerminalView.vue");
    const wrapper = mount(CloudTerminalView, {
      props: { ownerDesktopId: "desktop-1", ownerTaskId: "task-1" },
    });
    await flushPromises();
    const event = {
      type: "keydown",
      key: "c",
      metaKey: true,
      altKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(harness.keyHandler?.(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(clipboardWriteText).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
